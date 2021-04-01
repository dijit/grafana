package provisioning

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"

	"github.com/grafana/grafana/pkg/infra/log"
	plugifaces "github.com/grafana/grafana/pkg/plugins"
	"github.com/grafana/grafana/pkg/registry"
	"github.com/grafana/grafana/pkg/services/provisioning/dashboards"
	"github.com/grafana/grafana/pkg/services/provisioning/datasources"
	"github.com/grafana/grafana/pkg/services/provisioning/notifiers"
	"github.com/grafana/grafana/pkg/services/provisioning/plugins"
	"github.com/grafana/grafana/pkg/services/sqlstore"
	"github.com/grafana/grafana/pkg/setting"
	"github.com/grafana/grafana/pkg/util/errutil"
)

var ProvisioningServicePriority = registry.Low

type ProvisioningService interface {
	ProvisionDatasources() error
	ProvisionPlugins() error
	ProvisionNotifications() error
	ProvisionDashboards() error
	GetDashboardProvisionerResolvedPath(name string) string
	GetAllowUIUpdatesFromConfig(name string) bool
}

// InitProvisioner will be automatically added by the Provisioning Service
// to its internal list in order to dynamically execute on Init
type InitProvisioner interface {
	// To identify provisioners when building the dependency graph
	GetProvisionerUID() string
	// List of provisioners to start prior to this one
	GetDependencies() []string
	// Perform the provisioning of the yaml files located in configDir
	Provision(configDir string) error
}

func init() {
	registry.Register(&registry.Descriptor{
		Name: "ProvisioningService",
		Instance: newProvisioningServiceImpl(
			dashboards.New,
			notifiers.Provision,
			datasources.Provision,
			plugins.Provision,
		),
		InitPriority: ProvisioningServicePriority,
	})
}

func newProvisioningServiceImpl(
	newDashboardProvisioner dashboards.DashboardProvisionerFactory,
	provisionNotifiers func(string) error,
	provisionDatasources func(string) error,
	provisionPlugins func(string, plugifaces.Manager) error,
) *provisioningServiceImpl {
	return &provisioningServiceImpl{
		log:                     log.New("provisioning"),
		newDashboardProvisioner: newDashboardProvisioner,
		provisionNotifiers:      provisionNotifiers,
		provisionDatasources:    provisionDatasources,
		provisionPlugins:        provisionPlugins,
	}
}

type provisioningServiceImpl struct {
	Cfg                     *setting.Cfg                  `inject:""`
	RequestHandler          plugifaces.DataRequestHandler `inject:""`
	SQLStore                *sqlstore.SQLStore            `inject:""`
	PluginManager           plugifaces.Manager            `inject:""`
	initProvisioners        []InitProvisioner
	log                     log.Logger
	pollingCtxCancel        context.CancelFunc
	newDashboardProvisioner dashboards.DashboardProvisionerFactory
	dashboardProvisioner    dashboards.DashboardProvisioner
	provisionNotifiers      func(string) error
	provisionDatasources    func(string) error
	provisionPlugins        func(string, plugifaces.Manager) error
	mutex                   sync.Mutex
}

func (ps *provisioningServiceImpl) Init() error {
	err := ps.ProvisionDatasources()
	if err != nil {
		return err
	}

	err = ps.ProvisionPlugins()
	if err != nil {
		return err
	}

	err = ps.ProvisionNotifications()
	if err != nil {
		return err
	}

	ps.PopulateInitProvisioners()
	err = ps.LaunchInitProvisioners()
	if err != nil {
		return err
	}

	return nil
}

func (ps *provisioningServiceImpl) Run(ctx context.Context) error {
	err := ps.ProvisionDashboards()
	if err != nil {
		ps.log.Error("Failed to provision dashboard", "error", err)
		return err
	}

	for {
		// Wait for unlock. This is tied to new dashboardProvisioner to be instantiated before we start polling.
		ps.mutex.Lock()
		// Using background here because otherwise if root context was canceled the select later on would
		// non-deterministically take one of the route possibly going into one polling loop before exiting.
		pollingContext, cancelFun := context.WithCancel(context.Background())
		ps.pollingCtxCancel = cancelFun
		ps.dashboardProvisioner.PollChanges(pollingContext)
		ps.mutex.Unlock()

		select {
		case <-pollingContext.Done():
			// Polling was canceled.
			continue
		case <-ctx.Done():
			// Root server context was cancelled so cancel polling and leave.
			ps.cancelPolling()
			return ctx.Err()
		}
	}
}

func (ps *provisioningServiceImpl) ProvisionDatasources() error {
	datasourcePath := filepath.Join(ps.Cfg.ProvisioningPath, "datasources")
	err := ps.provisionDatasources(datasourcePath)
	return errutil.Wrap("Datasource provisioning error", err)
}

func (ps *provisioningServiceImpl) ProvisionPlugins() error {
	appPath := filepath.Join(ps.Cfg.ProvisioningPath, "plugins")
	err := ps.provisionPlugins(appPath, ps.PluginManager)
	return errutil.Wrap("app provisioning error", err)
}

func (ps *provisioningServiceImpl) ProvisionNotifications() error {
	alertNotificationsPath := filepath.Join(ps.Cfg.ProvisioningPath, "notifiers")
	err := ps.provisionNotifiers(alertNotificationsPath)
	return errutil.Wrap("Alert notification provisioning error", err)
}

func (ps *provisioningServiceImpl) ProvisionDashboards() error {
	dashboardPath := filepath.Join(ps.Cfg.ProvisioningPath, "dashboards")
	dashProvisioner, err := ps.newDashboardProvisioner(dashboardPath, ps.SQLStore, ps.RequestHandler)
	if err != nil {
		return errutil.Wrap("Failed to create provisioner", err)
	}

	ps.mutex.Lock()
	defer ps.mutex.Unlock()

	ps.cancelPolling()
	dashProvisioner.CleanUpOrphanedDashboards()

	err = dashProvisioner.Provision()
	if err != nil {
		// If we fail to provision with the new provisioner, the mutex will unlock and the polling will restart with the
		// old provisioner as we did not switch them yet.
		return errutil.Wrap("Failed to provision dashboards", err)
	}
	ps.dashboardProvisioner = dashProvisioner
	return nil
}

func (ps *provisioningServiceImpl) GetDashboardProvisionerResolvedPath(name string) string {
	return ps.dashboardProvisioner.GetProvisionerResolvedPath(name)
}

func (ps *provisioningServiceImpl) GetAllowUIUpdatesFromConfig(name string) bool {
	return ps.dashboardProvisioner.GetAllowUIUpdatesFromConfig(name)
}

func (ps *provisioningServiceImpl) cancelPolling() {
	if ps.pollingCtxCancel != nil {
		ps.log.Debug("Stop polling for dashboard changes")
		ps.pollingCtxCancel()
	}
	ps.pollingCtxCancel = nil
}

// PopulateInitProvisioners goes through the registry searching for
// InitProvisioner compliant services
func (ps *provisioningServiceImpl) PopulateInitProvisioners() {
	services := registry.GetServices()
	for _, s := range services {
		if registry.IsDisabled(s.Instance) {
			continue
		}
		if prov, ok := interface{}(s.Instance).(InitProvisioner); ok {
			ps.initProvisioners = append(ps.initProvisioners, prov)
		}
	}
}

// LaunchInitProvisioners launches the provisioners scheduling
// them based on their dependencies
func (ps *provisioningServiceImpl) LaunchInitProvisioners() error {
	accessControlPath := filepath.Join(ps.Cfg.ProvisioningPath, "accesscontrol")
	// ToDo create dependencies graph
	for _, prov := range ps.initProvisioners {
		err := prov.Provision(accessControlPath)
		if err != nil {
			return fmt.Errorf("Alert provisioning error: %w", err)
		}
	}
	return nil
}
