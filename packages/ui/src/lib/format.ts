/** 撮影日時を「2026/06/12 21:34」形式に整える。 */
export function formatTakenAt(takenAt: number): string {
  const date = new Date(takenAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
