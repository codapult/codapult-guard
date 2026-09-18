export async function load() {
  const module = await import('./module');
  return require('./module').value + module.value;
}
