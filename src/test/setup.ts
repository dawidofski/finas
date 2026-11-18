import 'fake-indexeddb/auto'
import '@testing-library/jest-dom/vitest'
import { configure } from '@testing-library/react'

// A screen that settles in well under a second alone can take longer when the whole suite runs at once (the backup tests
// derive real keys on every core). waitFor and findBy only wait for something to become true, so more time weakens nothing.
configure({ asyncUtilTimeout: 5000 })
