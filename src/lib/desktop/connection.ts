/** Keep the editor in sync with Electron, including after a missed status event. */
export function watchDesktopConnection(
  backend: NonNullable<Window['nodeBananaDesktop']>['backend'],
  onChange: (online: boolean) => void,
): () => void {
  let active = true;
  let revision = 0;
  const unsubscribe = backend.onStatus(online => {
    revision += 1;
    if (active) onChange(online);
  });
  const synchronize = () => {
    const requestedRevision = ++revision;
    void backend.state().then(online => {
      if (active && revision === requestedRevision) onChange(online);
    }).catch(() => {
      if (active && revision === requestedRevision) onChange(false);
    });
  };
  synchronize();
  window.addEventListener('focus', synchronize);
  return () => {
    active = false;
    unsubscribe();
    window.removeEventListener('focus', synchronize);
  };
}
