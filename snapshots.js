// Fetch snapshot metadata from the backend
export async function getSnapshots() {
  const res = await fetch("/get-snapshots");
  if (!res.ok) throw new Error(`Server error (${res.status})`);
  return res.json();
}

// Fetch locally stored snapshots without triggering backend refresh
export async function getLocalSnapshots() {
  const res = await fetch("/get-local-snapshots");
  if (!res.ok) throw new Error(`Server error (${res.status})`);
  return res.json();
}
