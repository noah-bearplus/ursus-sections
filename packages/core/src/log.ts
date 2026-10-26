export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  child(scope: string): Logger;
}

const quiet = () => process.env.SF_QUIET === '1';

export function createLogger(scope: string): Logger {
  const fmt = (msg: string) => `[${new Date().toISOString().slice(11, 19)}] ${scope.padEnd(18)} ${msg}`;
  return {
    info: (m) => {
      if (!quiet()) console.log(fmt(m));
    },
    warn: (m) => console.warn(fmt(`WARN ${m}`)),
    error: (m) => console.error(fmt(`ERROR ${m}`)),
    child: (s) => createLogger(`${scope}:${s}`),
  };
}
