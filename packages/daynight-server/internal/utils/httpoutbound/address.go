// Package httpoutbound provides a bounded HTTPS client with a fixed public-address policy.
package httpoutbound

import (
	_ "embed"
	"encoding/csv"
	"net/netip"
	"strings"
)

// IANA snapshots retrieved 2026-11-07:
// https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv
// SHA-256 cbc4b7653c8bc640ba1e8e5d4ebbf11e7c7a1d867e7f1593aad001d3f8632aac
// https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv
// SHA-256 bf56772aef97fbf9b4a27c98b8511f2bb1ba96da4b9ccc12ab203a2496faba66
//
//go:embed iana-ipv4.csv
var ipv4Registry string

//go:embed iana-ipv6.csv
var ipv6Registry string

type specialRange struct {
	prefix    netip.Prefix
	reachable bool
}

var specialRanges = parseRegistries(ipv4Registry, ipv6Registry)
var transitionRanges = []netip.Prefix{
	netip.MustParsePrefix("::/96"), netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("64:ff9b:1::/48"), netip.MustParsePrefix("2001::/32"),
	netip.MustParsePrefix("2002::/16"),
}

func parseRegistries(registries ...string) []specialRange {
	var result []specialRange
	for _, data := range registries {
		rows, err := csv.NewReader(strings.NewReader(data)).ReadAll()
		if err != nil {
			panic("invalid embedded IANA registry")
		}
		for _, row := range rows[1:] {
			if len(row) != 10 {
				panic("invalid embedded IANA row")
			}
			for _, entry := range strings.Split(row[0], ",") {
				fields := strings.Fields(entry)
				if len(fields) == 0 {
					panic("missing embedded IANA prefix")
				}
				prefix, err := netip.ParsePrefix(fields[0])
				if err != nil {
					panic("invalid embedded IANA prefix")
				}
				result = append(result, specialRange{prefix.Masked(), row[8] == "True"})
			}
		}
	}
	return result
}

// PublicAddress uses longest-prefix IANA classification after unmapping IPv4.
func PublicAddress(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || ip.Zone() != "" || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	// IPv6 global unicast allocation is 2000::/3; other unicast space is
	// reserved unless a future policy revision explicitly admits it.
	if ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	for _, prefix := range transitionRanges {
		if prefix.Contains(ip) {
			return false
		}
	}
	bits, allow := -1, true
	for _, entry := range specialRanges {
		if entry.prefix.Contains(ip) && entry.prefix.Bits() > bits {
			bits, allow = entry.prefix.Bits(), entry.reachable
		}
	}
	return allow
}
