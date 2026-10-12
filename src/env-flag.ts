/** Truthy env opt-in: "1", "true" or "yes", case-insensitive. */
export function envFlag(name: string): boolean {
  const value = (process.env[name] ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}
