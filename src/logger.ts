export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info(message: string): void {
    console.log(message);
  },
  error(message: string): void {
    console.error(message);
  },
};

export const silentLogger: Logger = {
  info(): void {},
  error(): void {},
};
