import { YunzhijiaAdapter } from '../../adapters/yunzhijia/index.js';

function defaultFactories() {
  return {
    yunzhijia: (options) => new YunzhijiaAdapter(options)
  };
}

export function createManagedChannelsRuntime({
  brokerUrl,
  channels = {},
  factories = defaultFactories()
} = {}) {
  const entries = [];
  const instances = [];

  function record(name, enabled, managed) {
    const existing = entries.find((item) => item.name === name);
    if (existing) {
      existing.enabled = enabled;
      existing.managed = managed;
      return;
    }

    entries.push({ name, enabled, managed });
  }

  return {
    async startAll() {
      const yunzhijia = channels.yunzhijia;
      if (!yunzhijia) {
        return;
      }

      if (!yunzhijia.enabled) {
        record('yunzhijia', false, false);
        return;
      }

      if (!yunzhijia.sendUrl) {
        throw new Error('managed channel misconfigured: channels.yunzhijia.sendUrl is required');
      }

      const instance = factories.yunzhijia({
        brokerUrl,
        sendUrl: yunzhijia.sendUrl
      });
      await instance.start();
      instances.push({ name: 'yunzhijia', instance });
      record('yunzhijia', true, true);
    },

    async stopAll() {
      for (const { instance } of [...instances].reverse()) {
        await instance.stop?.();
      }
      instances.length = 0;
    },

    describe() {
      return [...entries];
    }
  };
}
