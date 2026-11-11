/* The page behind a one-time sign-in link: keep this browser's sign-in in its storage for the panel's address,
   then open the panel. Browser storage stays with this exact address (port included) and is never sent to
   other programs, which a cookie for 127.0.0.1 would be. See tiinyui/browserauth.py. */
'use strict';
(function () {
  const meta = name => document.querySelector(`meta[name="${name}"]`)?.content || '';
  const cred = meta('tiiny-credential'), key = meta('tiiny-storage-key') || 'tiiny-ui-credential';
  try {
    localStorage.setItem(key, cred);
    if (localStorage.getItem(key) !== cred) throw new Error('not kept');
  } catch {
    document.title = 'Can’t sign in';
    document.querySelector('h1').textContent = 'This browser can’t stay signed in';
    document.getElementById('msg').textContent = 'It is blocking site data for this address. Allow cookies and site data for ' +
      location.host + ' in your browser’s settings, then open the panel again from your app menu (or run python3 tiiny_ui.py).';
    return;
  }
  location.replace('/');
})();
