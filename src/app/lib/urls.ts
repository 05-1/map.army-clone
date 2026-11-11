// Links to the other entry points. Resolved against the page's own URL, so they are right at
// localhost, at https://user.github.io/repo/ and at a custom domain root without any configuration.
// Tokens go in the fragment: browsers never send it to the host or to tile servers.
const page = (file: string, token: string) => `${new URL(file, document.baseURI).href}#${token}`;

export const viewUrl = (token: string) => page('view.html', token);
export const playUrl = (token: string) => page('play.html', token);
