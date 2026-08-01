export function formatLek(value: number): string {
  return `${value.toLocaleString('en-US')} L`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

// Soft, readable avatar tints — deterministic per name.
const AVATAR_TINTS = [
  { bg: '#e7f1ef', fg: '#0b5e57' },
  { bg: '#eef0f8', fg: '#3a4ba0' },
  { bg: '#fbeee6', fg: '#a85617' },
  { bg: '#f0eaf6', fg: '#6b3fa0' },
  { bg: '#e9f2e7', fg: '#3f7a3a' },
  { bg: '#fbe9ec', fg: '#a8324a' },
];

export function avatarTint(name: string) {
  let sum = 0;
  for (const ch of name) sum += ch.charCodeAt(0);
  return AVATAR_TINTS[sum % AVATAR_TINTS.length]!;
}
