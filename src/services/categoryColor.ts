// Deterministic color per category name, so a custom category always gets the
// same distinct color everywhere it's shown, without the user having to pick one.
export function colorForCategoryName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 45%)`;
}
