/**
 * worker.js — protège le site par basic auth.
 * Les flux .ics restent accessibles sans auth (Google Calendar n'envoie pas d'identifiants) :
 * leur sécurité repose sur un nom de fichier non devinable (voir FEED_SECRET dans build.js).
 * Secrets runtime attendus : AUTH_USER, AUTH_PASS (ASCII uniquement).
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('.ics')) return env.ASSETS.fetch(request);

    const expected = 'Basic ' + btoa(`${env.AUTH_USER}:${env.AUTH_PASS}`);
    if (request.headers.get('Authorization') === expected) return env.ASSETS.fetch(request);

    return new Response('Accès restreint', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Planning", charset="UTF-8"' },
    });
  },
};
