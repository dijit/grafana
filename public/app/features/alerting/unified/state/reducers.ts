import { combineReducers } from 'redux';
import { createAsyncMapSlice, createAsyncSlice } from '../utils/redux';
import {
  fetchAlertManagerConfigAction,
  fetchExistingRuleAction,
  fetchGrafanaNotifiersAction,
  fetchPromRulesAction,
  fetchRulerRulesAction,
  fetchSilencesAction,
  saveRuleFormAction,
} from './actions';

export const reducer = combineReducers({
  promRules: createAsyncMapSlice('promRules', fetchPromRulesAction, (dataSourceName) => dataSourceName).reducer,
  rulerRules: createAsyncMapSlice('rulerRules', fetchRulerRulesAction, (dataSourceName) => dataSourceName).reducer,
  amConfigs: createAsyncMapSlice(
    'amConfigs',
    fetchAlertManagerConfigAction,
    (alertManagerSourceName) => alertManagerSourceName
  ).reducer,
  silences: createAsyncMapSlice('silences', fetchSilencesAction, (alertManagerSourceName) => alertManagerSourceName)
    .reducer,
  ruleForm: combineReducers({
    saveRule: createAsyncSlice('saveRule', saveRuleFormAction).reducer,
    existingRule: createAsyncSlice('existingRule', fetchExistingRuleAction).reducer,
  }),
  grafanaNotifiers: createAsyncSlice('grafanaNotifiers', fetchGrafanaNotifiersAction).reducer,
});

export type UnifiedAlertingState = ReturnType<typeof reducer>;

export default reducer;
