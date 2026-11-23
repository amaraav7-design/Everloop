export async function revokePushOnThisDevice() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  try {
    const response = await fetch('/api/mobile/push', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error('Could not remove the device subscription');
  } finally {
    await subscription.unsubscribe();
  }
}
