import { describe, expect, it, vi } from 'vitest'
import {
  BatchVerifier,
  computeChunkedSha256,
  tryParseManifest,
  type BatchConfig,
} from './batchVerifier'

// Stego extraction decodes pixels from a real <video> element, which jsdom cannot
// drive (it never fires loadedmetadata/error for a blob URL). These tests cover
// batch orchestration only, so extraction is stubbed the same way
// verificationFlow.test.ts stubs it.
const { extractMetadata } = vi.hoisted(() => ({ extractMetadata: vi.fn() }))

vi.mock('./stego', () => ({
  extractMetadata,
  MalformedEvidenceError: class MalformedEvidenceError extends Error {
    constructor() {
      super('Malformed evidence')
      this.name = 'MalformedEvidenceError'
    }
  },
}))

function stubChainLookup(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ events: [] }),
    }),
  )
}

describe('batchVerifier', () => {
  describe('computeChunkedSha256', () => {
    it('computes sha256 for small files', async () => {
      const content = 'Harpocrates test video payload'
      const file = new File([content], 'test.mp4', { type: 'video/mp4' })
      const hash = await computeChunkedSha256(file)

      // Compare with WebCrypto direct digest
      const direct = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')

      expect(hash).toBe(direct)
    })

    it('respects AbortSignal during hashing', async () => {
      const controller = new AbortController()
      controller.abort()

      const file = new File(['data'], 'test.mp4', { type: 'video/mp4' })
      await expect(computeChunkedSha256(file, controller.signal)).rejects.toThrow('Operation cancelled.')
    })
  })

  describe('tryParseManifest', () => {
    it('parses valid Harpocrates JSON manifest', async () => {
      const manifestJson = JSON.stringify({
        protocol: 'harpocrates',
        version: 1,
        proofId: '0x123',
        tier: 'silent',
        network: 'testnet',
        contractId: 'CC123',
        transactionRef: '0xabc',
        videoHash: '1111222233334444555566667777888811112222333344445555666677778888',
        metadataHash: 'aaaa222233334444555566667777888811112222333344445555666677778888',
        sourceHash: '1111222233334444555566667777888811112222333344445555666677778888',
        timestamp: '2026-07-25T00:00:00Z',
      })

      const file = new File([manifestJson], 'receipt.json', { type: 'application/json' })
      const result = await tryParseManifest(file)
      expect(result).not.toBeNull()
      expect(result?.protocol).toBe('harpocrates')
      expect(result?.videoHash).toBe('1111222233334444555566667777888811112222333344445555666677778888')
    })

    it('returns null for non-json or invalid manifest format', async () => {
      const file = new File(['not json'], 'receipt.txt', { type: 'text/plain' })
      const result = await tryParseManifest(file)
      expect(result).toBeNull()
    })
  })

  describe('BatchVerifier Worker Pool', () => {
    it('enforces per-file size limits upfront', async () => {
      const config: Partial<BatchConfig> = {
        maxFileSizeBytes: 100, // 100 bytes max
        maxTotalSizeBytes: 1000,
      }
      const verifier = new BatchVerifier(config)
      extractMetadata.mockResolvedValue({ protocol: 'harpocrates' })
      stubChainLookup()

      const fileNormal = new File(['short'], 'ok.mp4', { type: 'video/mp4' })
      const fileOversized = new File(['a'.repeat(200)], 'large.mp4', { type: 'video/mp4' })

      const { items } = await verifier.runBatch([fileNormal, fileOversized])

      const oversizedItem = items.find((i) => i.fileName === 'large.mp4')
      expect(oversizedItem?.status).toBe('oversized')
      expect(oversizedItem?.message).toContain('exceeds size limit')

      vi.unstubAllGlobals()
    })

    it('enforces max total batch size limit', async () => {
      const config: Partial<BatchConfig> = {
        maxFileSizeBytes: 1000,
        maxTotalSizeBytes: 250, // total 250 bytes max
      }
      const verifier = new BatchVerifier(config)
      extractMetadata.mockResolvedValue({ protocol: 'harpocrates' })
      stubChainLookup()

      const f1 = new File(['a'.repeat(150)], 'f1.mp4')
      const f2 = new File(['a'.repeat(150)], 'f2.mp4')

      const { items } = await verifier.runBatch([f1, f2])
      const f2Item = items.find((i) => i.fileName === 'f2.mp4')
      expect(f2Item?.status).toBe('oversized')
      expect(f2Item?.message).toContain('Total batch size limit exceeded')

      vi.unstubAllGlobals()
    })


    it('detects duplicate files in batch', async () => {
      const verifier = new BatchVerifier({
        maxConcurrency: 1,
        apiBase: 'http://127.0.0.1:5050',
      })

      extractMetadata.mockResolvedValue({ protocol: 'harpocrates' })

      // Mock global fetch for the on-chain lookup that follows extraction
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
          if (url.includes('/api/proofs/by-video/')) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ events: [] }),
            })
          }
          return Promise.reject(new Error('Unknown url'))
        }),
      )

      const f1 = new File(['identical content payload'], 'video1.mp4', { type: 'video/mp4' })
      const f2 = new File(['identical content payload'], 'video2.mp4', { type: 'video/mp4' })

      const { items } = await verifier.runBatch([f1, f2])

      const dupItem = items.find((i) => i.fileName === 'video2.mp4')
      expect(dupItem?.status).toBe('duplicate')
      expect(dupItem?.duplicateOf).toBe('video1.mp4')
      expect(dupItem?.message).toContain('Duplicate file detected')

      vi.unstubAllGlobals()
    })

    it('isolates single file failures without failing entire batch', async () => {
      const verifier = new BatchVerifier({ maxConcurrency: 2 })

      const { MalformedEvidenceError } = await import('./stego')
      // The corrupt artifact has no readable embedded metadata, which is what
      // surfaces to the batch item as a 'malformed' outcome.
      extractMetadata.mockImplementation(async (file: File) => {
        if (file.name === 'bad.mp4') {
          throw new MalformedEvidenceError()
        }
        return { protocol: 'harpocrates' }
      })

      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((url: string) => {
          if (url.includes('/api/proofs/by-video/')) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ events: [] }),
            })
          }
          return Promise.reject(new Error('Network error'))
        }),
      )

      const fGood = new File(['good content'], 'good.mp4')
      const fBad = new File(['bad content'], 'bad.mp4')

      const { items } = await verifier.runBatch([fGood, fBad])

      expect(items).toHaveLength(2)
      const badItem = items.find((i) => i.fileName === 'bad.mp4')
      expect(badItem?.status).toBe('malformed')

      vi.unstubAllGlobals()
    })

    it('supports batch cancellation', async () => {
      const verifier = new BatchVerifier({ maxConcurrency: 1 })
      const f1 = new File(['content 1'], 'f1.mp4')
      const f2 = new File(['content 2'], 'f2.mp4')

      const promise = verifier.runBatch([f1, f2])
      verifier.cancel()
      const { items } = await promise

      expect(items.some((i) => i.status === 'cancelled')).toBe(true)
    })
  })
})
