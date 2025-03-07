import Centrifuge from 'centrifuge/dist/centrifuge';
import {
  GrafanaLiveSrv,
  setGrafanaLiveSrv,
  getGrafanaLiveSrv,
  config,
  LiveDataStreamOptions,
  toDataQueryError,
} from '@grafana/runtime';
import { BehaviorSubject, Observable, of } from 'rxjs';
import {
  LiveChannelScope,
  LiveChannelAddress,
  LiveChannelConnectionState,
  LiveChannelConfig,
  LiveChannelEvent,
  DataQueryResponse,
  LiveChannelPresenceStatus,
  isValidLiveChannelAddress,
  LoadingState,
  DataFrameJSON,
  StreamingDataFrame,
  DataFrame,
  dataFrameToJSON,
  isLiveChannelMessageEvent,
  isLiveChannelStatusEvent,
} from '@grafana/data';
import { CentrifugeLiveChannel, getErrorChannel } from './channel';
import {
  GrafanaLiveScope,
  grafanaLiveCoreFeatures,
  GrafanaLiveDataSourceScope,
  GrafanaLivePluginScope,
  GrafanaLiveStreamScope,
} from './scopes';
import { registerLiveFeatures } from './features';
import { perf } from './perf';

export const sessionId =
  (window as any)?.grafanaBootData?.user?.id +
  '/' +
  Date.now().toString(16) +
  '/' +
  Math.random().toString(36).substring(2, 15);

export class CentrifugeSrv implements GrafanaLiveSrv {
  readonly open = new Map<string, CentrifugeLiveChannel>();
  readonly centrifuge: Centrifuge;
  readonly connectionState: BehaviorSubject<boolean>;
  readonly connectionBlocker: Promise<void>;
  readonly scopes: Record<LiveChannelScope, GrafanaLiveScope>;

  constructor() {
    // build live url replacing scheme in appUrl.
    const liveUrl = `${config.appUrl}live/ws`.replace(/^(http)(s)?:\/\//, 'ws$2://');
    this.centrifuge = new Centrifuge(liveUrl, {
      debug: true,
    });
    this.centrifuge.setConnectData({
      sessionId,
    });
    this.centrifuge.connect(); // do connection
    this.connectionState = new BehaviorSubject<boolean>(this.centrifuge.isConnected());
    this.connectionBlocker = new Promise<void>((resolve) => {
      if (this.centrifuge.isConnected()) {
        return resolve();
      }
      const connectListener = () => {
        resolve();
        this.centrifuge.removeListener('connect', connectListener);
      };
      this.centrifuge.addListener('connect', connectListener);
    });

    this.scopes = {
      [LiveChannelScope.Grafana]: grafanaLiveCoreFeatures,
      [LiveChannelScope.DataSource]: new GrafanaLiveDataSourceScope(),
      [LiveChannelScope.Plugin]: new GrafanaLivePluginScope(),
      [LiveChannelScope.Stream]: new GrafanaLiveStreamScope(),
    };

    // Register global listeners
    this.centrifuge.on('connect', this.onConnect);
    this.centrifuge.on('disconnect', this.onDisconnect);
    this.centrifuge.on('publish', this.onServerSideMessage);
  }

  //----------------------------------------------------------
  // Internal functions
  //----------------------------------------------------------

  onConnect = (context: any) => {
    console.log('CONNECT', context);
    this.connectionState.next(true);
  };

  onDisconnect = (context: any) => {
    console.log('onDisconnect', context);
    this.connectionState.next(false);
  };

  onServerSideMessage = (context: any) => {
    console.log('Publication from server-side channel', context);
  };

  /**
   * Get a channel.  If the scope, namespace, or path is invalid, a shutdown
   * channel will be returned with an error state indicated in its status
   */
  getChannel<TMessage>(addr: LiveChannelAddress): CentrifugeLiveChannel<TMessage> {
    const id = `${addr.scope}/${addr.namespace}/${addr.path}`;
    let channel = this.open.get(id);
    if (channel != null) {
      return channel;
    }

    const scope = this.scopes[addr.scope];
    if (!scope) {
      return getErrorChannel<TMessage>('invalid scope', id, addr) as any;
    }

    channel = new CentrifugeLiveChannel(id, addr);
    channel.shutdownCallback = () => {
      this.open.delete(id); // remove it from the list of open channels
    };
    this.open.set(id, channel);

    // Initialize the channel in the background
    this.initChannel(scope, channel).catch((err) => {
      if (channel) {
        channel.currentStatus.state = LiveChannelConnectionState.Invalid;
        channel.shutdownWithError(err);
      }
      this.open.delete(id);
    });

    // return the not-yet initalized channel
    return channel;
  }

  private async initChannel(scope: GrafanaLiveScope, channel: CentrifugeLiveChannel): Promise<void> {
    const { addr } = channel;
    const support = await scope.getChannelSupport(addr.namespace);
    if (!support) {
      throw new Error(channel.addr.namespace + ' does not support streaming');
    }
    const config = support.getChannelConfig(addr.path);
    if (!config) {
      throw new Error('unknown path: ' + addr.path);
    }
    const events = channel.initalize(config);
    if (!this.centrifuge.isConnected()) {
      await this.connectionBlocker;
    }
    channel.subscription = this.centrifuge.subscribe(channel.id, events);
    return;
  }

  //----------------------------------------------------------
  // Exported functions
  //----------------------------------------------------------

  /**
   * Listen for changes to the connection state
   */
  getConnectionState() {
    return this.connectionState.asObservable();
  }

  /**
   * Get a channel.  If the scope, namespace, or path is invalid, a shutdown
   * channel will be returned with an error state indicated in its status.
   *
   * This is a singleton instance that stays active until explicitly shutdown.
   * Multiple requests for this channel will return the same object until
   * the channel is shutdown
   */
  async getChannelInfo(addr: LiveChannelAddress): Promise<LiveChannelConfig> {
    const scope = this.scopes[addr.scope];
    if (!scope) {
      return Promise.reject('invalid scope');
    }

    const support = await scope.getChannelSupport(addr.namespace);
    if (!support) {
      return Promise.reject(addr.namespace + ' does not support streaming');
    }
    return support.getChannelConfig(addr.path)!;
  }

  /**
   * Watch for messages in a channel
   */
  getStream<T>(address: LiveChannelAddress): Observable<LiveChannelEvent<T>> {
    return this.getChannel<T>(address).getStream();
  }

  /**
   * Connect to a channel and return results as DataFrames
   */
  getDataStream(options: LiveDataStreamOptions): Observable<DataQueryResponse> {
    if (!isValidLiveChannelAddress(options.addr)) {
      return of({
        error: toDataQueryError(`invalid channel address: ${JSON.stringify(options.addr)}`),
        state: LoadingState.Error,
        data: options.frame ? [options.frame] : [],
      });
    }

    return new Observable<DataQueryResponse>((subscriber) => {
      const channel = this.getChannel(options.addr);
      let data: StreamingDataFrame | undefined = undefined;
      let filtered: DataFrame | undefined = undefined;
      let state = LoadingState.Loading;
      let { key } = options;
      let last = perf.last;
      if (options.frame) {
        const msg = dataFrameToJSON(options.frame);
        data = new StreamingDataFrame(msg, options.buffer);
        state = LoadingState.Streaming;
      }
      if (channel.lastMessageWithSchema && !data) {
        data = new StreamingDataFrame(channel.lastMessageWithSchema, options.buffer);
      }

      if (!key) {
        key = `xstr/${streamCounter++}`;
      }

      const process = (msg: DataFrameJSON) => {
        if (!data) {
          data = new StreamingDataFrame(msg, options.buffer);
        } else {
          data.push(msg);
        }
        state = LoadingState.Streaming;

        // Filter out fields
        if (!filtered || msg.schema) {
          filtered = data;
          if (options.filter) {
            const { fields } = options.filter;
            if (fields?.length) {
              filtered = {
                ...data,
                fields: data.fields.filter((f) => fields.includes(f.name)),
              };
            }
          }
        }

        const elapsed = perf.last - last;
        if (elapsed > 1000 || perf.ok) {
          filtered.length = data.length; // make sure they stay up-to-date
          subscriber.next({ state, data: [filtered], key });
          last = perf.last;
        }
      };

      const sub = channel.getStream().subscribe({
        error: (err: any) => {
          console.log('LiveQuery [error]', { err }, options.addr);
          state = LoadingState.Error;
          subscriber.next({ state, data: [data], key, error: toDataQueryError(err) });
          sub.unsubscribe(); // close after error
        },
        complete: () => {
          console.log('LiveQuery [complete]', options.addr);
          if (state !== LoadingState.Error) {
            state = LoadingState.Done;
          }
          // or track errors? subscriber.next({ state, data: [data], key });
          subscriber.complete();
          sub.unsubscribe();
        },
        next: (evt: LiveChannelEvent) => {
          if (isLiveChannelMessageEvent(evt)) {
            process(evt.message);
            return;
          }
          if (isLiveChannelStatusEvent(evt)) {
            if (evt.error) {
              let error = toDataQueryError(evt.error);
              error.message = `Streaming channel error: ${error.message}`;
              state = LoadingState.Error;
              subscriber.next({ state, data: [data], key, error });
              return;
            } else if (
              evt.state === LiveChannelConnectionState.Connected ||
              evt.state === LiveChannelConnectionState.Pending
            ) {
              if (evt.message) {
                process(evt.message);
              }
              return;
            }
            console.log('ignore state', evt);
          }
        },
      });

      return () => {
        sub.unsubscribe();
      };
    });
  }

  /**
   * For channels that support presence, this will request the current state from the server.
   *
   * Join and leave messages will be sent to the open stream
   */
  getPresence(address: LiveChannelAddress): Promise<LiveChannelPresenceStatus> {
    return this.getChannel(address).getPresence();
  }
}

// This is used to give a unique key for each stream.  The actual value does not matter
let streamCounter = 0;

export function getGrafanaLiveCentrifugeSrv() {
  return getGrafanaLiveSrv() as CentrifugeSrv;
}

export function initGrafanaLive() {
  setGrafanaLiveSrv(new CentrifugeSrv());
  registerLiveFeatures();
}
