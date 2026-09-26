import { useEffect, useRef, useState, useCallback } from 'react'
import { EvidenceStateMachine, type EvidenceState, type EvidenceEvent } from '../evidenceStateMachine'
import { CheckpointStorage } from '../checkpointStorage'

export function useEvidenceState() {
  const machineRef = useRef<EvidenceStateMachine | null>(null)
  const [state, setState] = useState<EvidenceState>({
    stage: 'idle',
    tier: 'silent',
    updatedAt: 0,
  })
  const [hasCheckpoint, setHasCheckpoint] = useState(() => CheckpointStorage.hasCheckpoint())

  useEffect(() => {
    if (!machineRef.current) {
      machineRef.current = new EvidenceStateMachine()
      setState(machineRef.current.getState())
    }

    const unsubscribe = machineRef.current.subscribe((nextState) => {
      setState(nextState)
    })
    return unsubscribe
  }, [])

  const send = useCallback((event: EvidenceEvent) => {
    if (!machineRef.current) {
      machineRef.current = new EvidenceStateMachine()
    }
    machineRef.current.send(event)
  }, [])

  const setPassword = useCallback((password: string) => {
    if (!machineRef.current) {
      machineRef.current = new EvidenceStateMachine()
    }
    machineRef.current.setPassword(password)
  }, [])

  const loadCheckpoint = useCallback(async (password: string) => {
    try {
      const stored = await CheckpointStorage.load(password)
      if (stored) {
        const nextMachine = new EvidenceStateMachine(stored, password)
        machineRef.current = nextMachine
        setState(nextMachine.getState())
        setHasCheckpoint(false) // Loaded, no longer just "has" it
        return true
      }
    } catch (error) {
      console.error(error)
    }
    return false
  }, [])

  const clearCheckpoint = useCallback(() => {
    CheckpointStorage.clear()
    setHasCheckpoint(false)
  }, [])

  return { state, send, setPassword, loadCheckpoint, clearCheckpoint, hasCheckpoint }
}
