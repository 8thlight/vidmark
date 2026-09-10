// A failed source is evidence the source was NOT read, not a fatal build error.
export async function researchFetchResult(url: string, fetchText: (url: string) => Promise<string>) {
  try {
    const content = (await fetchText(url)).trim();
    if (!content) throw new Error("The source returned no readable evidence.");
    return { ok: true as const, url, content, accessedAt: new Date().toISOString() };
  } catch (error) {
    return { ok: false as const, url, error: error instanceof Error ? error.message : "Source fetch failed.", guidance: "This source was not read. Do not cite it as verified evidence. Correct the URL or use another authorized primary source. If no source is accessible, record the evidence gap instead of inventing content. Do not bypass access restrictions." };
  }
}
