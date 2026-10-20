// Sequential callbacks preserve ordering and short-circuit behavior when a
// database read/write is required inside a former synchronous collection step.
export async function asyncMap<T, U>(
  items: readonly T[],
  fn: (item: T, index: number) => U | Promise<U>,
): Promise<Awaited<U>[]> {
  const result: Awaited<U>[] = [];
  for (let i = 0; i < items.length; i++) result.push(await fn(items[i], i));
  return result;
}
export async function asyncFilter<T>(
  items: readonly T[],
  fn: (item: T, index: number) => unknown,
): Promise<T[]> {
  const result: T[] = [];
  for (let i = 0; i < items.length; i++) if (await fn(items[i], i)) result.push(items[i]);
  return result;
}
export async function asyncFind<T>(
  items: readonly T[],
  fn: (item: T, index: number) => unknown,
): Promise<T | undefined> {
  for (let i = 0; i < items.length; i++) if (await fn(items[i], i)) return items[i];
}
export async function asyncSome<T>(
  items: readonly T[],
  fn: (item: T, index: number) => unknown,
): Promise<boolean> {
  for (let i = 0; i < items.length; i++) if (await fn(items[i], i)) return true;
  return false;
}
export async function asyncEvery<T>(
  items: readonly T[],
  fn: (item: T, index: number) => unknown,
): Promise<boolean> {
  for (let i = 0; i < items.length; i++) if (!(await fn(items[i], i))) return false;
  return true;
}
export async function asyncForEach<T>(
  items: readonly T[],
  fn: (item: T, index: number) => unknown,
): Promise<void> {
  for (let i = 0; i < items.length; i++) await fn(items[i], i);
}
export async function asyncFlatMap<T, U>(
  items: readonly T[],
  fn: (item: T, index: number) => readonly U[] | Promise<readonly U[]>,
): Promise<U[]> {
  const result: U[] = [];
  for (let i = 0; i < items.length; i++) result.push(...(await fn(items[i], i)));
  return result;
}
