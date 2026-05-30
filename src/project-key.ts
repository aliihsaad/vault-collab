export function projectKey(project: string): string {
  const normalized = project.normalize("NFKC").trim().toLowerCase();
  const slug = normalized
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

  return slug || normalized;
}

export function sameProject(left: string, right: string): boolean {
  return projectKey(left) === projectKey(right);
}
