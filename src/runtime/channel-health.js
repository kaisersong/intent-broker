export function createChannelHealthRegistry() {
  const states = new Map();

  return {
    update(name, state) {
      states.set(name, { name, ...state, updatedAt: new Date().toISOString() });
    },
    list() {
      return [...states.values()];
    },
    summarize() {
      const channels = [...states.values()];
      const degraded = channels.some((item) => item.status !== 'healthy');
      return {
        degraded,
        channels,
        reasons: channels.filter((item) => item.status !== 'healthy').map((item) => `${item.name}:${item.status}`)
      };
    }
  };
}
