// Expand through the same visible summary a user selects. Repeated calls leave
// the controls open; never force-click a hidden download or mutate details.open.
export async function openDownloads(page) {
  const library = page.locator("#library-view");
  if (!(await library.isVisible())) await page.locator("#open-library").click();
  const section = page.locator("#downloads-recovery");
  if (!(await section.evaluate((element) => element.open)))
    await section.getByText("Backup and recovery", { exact: true }).click();
}
