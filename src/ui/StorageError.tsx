export type StorageFailureReason = 'blocked' | 'unsupported' | 'corrupt' | 'unknown'

const CAUSE: Record<StorageFailureReason, { cause: string; remedy: string }> = {
  blocked: {
    cause: 'Your browser is refusing to let this app keep data on this device. This usually happens in a private or incognito window, or when site data is blocked.',
    remedy: 'Open the app in a normal (non-private) window and allow site data for this address in your browser settings. If you have a backup file, you can restore it once storage works.',
  },
  unsupported: {
    cause: 'This browser does not offer the local storage this app needs.',
    remedy: 'Use a current version of Chrome, Edge, Firefox or Safari in a normal window. If you have a backup file, you can restore it there.',
  },
  unknown: {
    cause: 'The app could not open its stored data, and the cause is not one it recognises. The technical detail below is shown so the problem can be diagnosed.',
    remedy: 'Your data is most likely intact: nothing here indicates that anything was lost or damaged. Reload the page, free some disk space if your device is nearly full, and try again. Do not clear site data, with one exception: if you are the developer and this profile opened an earlier development build (the schema was edited in place at version 1, which the browser reports as a mismatch), clearing site data for this address is the fix, and only safe while there is nothing in it you need.',
  },
  corrupt: {
    cause: 'The data stored by this app could not be opened. It may be damaged, or it may have been written by a newer version of the app.',
    remedy: 'Reload the page. If it persists, update the app, or restore from a backup file. Do not clear site data until you have a backup.',
  },
}

export default function StorageError({ reason, detail }: { reason: StorageFailureReason; detail: string }) {
  const { cause, remedy } = CAUSE[reason]
  return (
    <main role="alert" style={{ maxWidth: '40rem', margin: '3rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Your financial data cannot be stored</h1>
      <p>Nothing can be saved or shown until this is fixed, so the app has stopped here instead of showing empty screens.</p>
      <h2>What happened</h2>
      <p>{cause}</p>
      <h2>What to do</h2>
      <p>{remedy}</p>
      <p><small>Technical detail: {detail}</small></p>
    </main>
  )
}
