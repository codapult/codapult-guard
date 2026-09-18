import pc from 'picocolors';

export const heading = (value: string): void => console.log(`\n${pc.bold(pc.cyan(value))}\n`);
export const success = (value: string): void => console.log(pc.green(`✓ ${value}`));
export const info = (value: string): void => console.log(pc.cyan(`ℹ ${value}`));
export const warn = (value: string): void => console.warn(pc.yellow(`⚠ ${value}`));
export const fail = (value: string): void => console.error(pc.red(`✗ ${value}`));
export const dim = (value: string): void => console.log(pc.dim(value));
