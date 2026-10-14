export function log(service: string, message: string): void {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`${time} [${service.padEnd(9)}] ${message}`);
}
