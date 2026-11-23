export const completionProgress = ({ done, cancelled, total }: { readonly done: number; readonly cancelled: number; readonly total: number }) => {
  const displayTotal = total - cancelled;
  const widthPercent = displayTotal === 0 ? 0 : done * 100 / displayTotal;
  return { displayDone: done, displayTotal, percent: Math.floor(widthPercent), widthPercent };
};
