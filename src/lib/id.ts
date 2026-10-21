let counter = 0;

/** Short, collision-resistant ids that are stable enough for serialization. */
export function uid(prefix = "x"): string {
  counter += 1;
  const rand = Math.floor(Math.random() * 0xffffff).toString(36);
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}
