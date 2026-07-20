export type PingSignalTone = 1 | 2 | 3 | 4 | 5

export function getLatencySignalTone(latency: number): PingSignalTone {
  if (latency <= 60)
    return 1
  if (latency <= 100)
    return 2
  if (latency <= 160)
    return 3
  if (latency <= 200)
    return 4
  return 5
}

export function getLossSignalTone(loss: number): PingSignalTone {
  if (loss <= 1)
    return 1
  if (loss <= 3)
    return 2
  if (loss <= 6)
    return 3
  if (loss <= 9)
    return 4
  return 5
}

export function getPingSignalBackgroundClass(tone: PingSignalTone): string {
  if (tone === 1)
    return 'bg-signal-1'
  if (tone === 2)
    return 'bg-signal-2'
  if (tone === 3)
    return 'bg-signal-3 ping-signal-pattern-2'
  if (tone === 4)
    return 'bg-signal-4 ping-signal-pattern-3'
  return 'bg-signal-5 ping-signal-pattern-4'
}
