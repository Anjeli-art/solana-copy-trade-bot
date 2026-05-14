export function getPositionCloseSignal(
  multiplier: number,
  targetMultiplier: number,
  stopLossMultiplier: number,
  positionAgeMs = 0,
  positionTimeoutMinutes = 0
) {
  if (multiplier >= targetMultiplier) {
    return "take-profit" as const;
  }

  if (stopLossMultiplier > 0 && multiplier <= stopLossMultiplier) {
    return "stop-loss" as const;
  }

  if (positionTimeoutMinutes > 0 && positionAgeMs >= positionTimeoutMinutes * 60 * 1000) {
    return "timeout" as const;
  }

  return null;
}
