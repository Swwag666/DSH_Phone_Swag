//#region lib/index.js
/**
 * dsh-phone-bridge plugin, node half. Pure browser-side plugin: the empty apply
 * exists so the plugin appears in the host cordis.yml / Loader (which is what
 * makes dsh-client-modules scan the dsh.client declaration in this package's
 * manifest); the browser half ships via exports["./client"].
 */
/** Host plugin body — no host-side behavior for this source plugin. */
function apply() {}
//#endregion
export { apply };
