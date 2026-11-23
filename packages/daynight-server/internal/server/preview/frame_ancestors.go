package preview

import "net"

// Every ancestor must be the main site, the document itself, or a Task host
// under the configured preview origin. The wildcard is needed because an SSO
// error cannot identify its ancestor Task after cross-origin navigation.
func (h *Routes) frameAncestors() string {
	result := "'self' " + h.main.String()
	if net.ParseIP(h.preview.Hostname()) == nil {
		result += " " + h.preview.Scheme + "://*." + h.preview.Host
	}
	return result
}
