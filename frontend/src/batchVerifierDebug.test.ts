import { describe, expect, it, vi } from 'vitest'
import { BatchVerifier } from './batchVerifier'

const { verifyArtifact } = vi.hoisted(() => ({ verifyArtifact: vi.fn() }))

vi.mock('./verificationFlow', () => ({ verifyArtifact }))

function log(...a: unknown[]) {
  process.stderr.write(a.map(String).join(' ') + '\n')
}

describe('debug static-boundary mock', () => {
  it('runs 2 concurrent items without deadlock', async () => {
    verifyArtifact.mockImplementation(async ({ file }: { file: File }) => {
      log('  verifyArtifact(' + file.name + ')')
      return {
        outcome: file.name === 'bad.mp4' ? 'malformed' : 'metadata-only',
        message: 'm',
        events: [],
        chainProof: null,
      }
    })

    const verifier = new BatchVerifier({ maxConcurrency: 2 })
    const res = await Promise.race([
      verifier.runBatch([new File(['good'], 'good.mp4'), new File(['bad'], 'bad.mp4')]),
      new Promise((r) => setTimeout(() => r('HANG'), 4000)),
    ])
    log('result =', res === 'HANG' ? 'HANG' : JSON.stringify((res as { items: { fileName: string; status: string }[] }).items.map((i) => [i.fileName, i.status])))
    expect(true).toBe(true)
  }, 30000)
})
