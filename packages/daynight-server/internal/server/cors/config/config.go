package config

import (
	"fmt"
	"net/netip"
	"strconv"
	"strings"

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

type Config struct {
	AllowedOrigin string `yaml:"allowed_origin"`
}

type Patch struct {
	AllowedOrigin *string `yaml:"allowed_origin"`
}

func (p Patch) ApplyTo(c *Config) error {
	if p.AllowedOrigin != nil {
		c.AllowedOrigin = *p.AllowedOrigin
	}
	return nil
}

func (c *Config) ApplyEnvironment(lookup func(string) (string, bool), mark func(string, string)) error {
	const variable = "DAYNIGHT_S2S_ALLOWED_ORIGIN"
	if value, ok := lookup(variable); ok {
		c.AllowedOrigin = value
		mark("allowed_origin", variable)
	}
	return nil
}

func (c Config) Validate(allowHTTPTestOrigin bool) error {
	if c.AllowedOrigin == "" {
		return nil
	}
	failure := func() error {
		return &configvalue.ConfigurationError{Field: "allowed_origin", Rule: "must be one canonical HTTPS origin, or an explicitly enabled loopback HTTP test origin"}
	}
	origin, err := authconfig.ValidatePublicOrigin(authconfig.AuthSettings{PublicOrigin: c.AllowedOrigin, AllowHTTPTestOrigin: allowHTTPTestOrigin})
	if err != nil {
		return failure()
	}
	host := origin.Hostname()
	if strings.ContainsAny(host, "*%\\") || strings.ContainsFunc(host, func(r rune) bool { return r < 0x21 || r > 0x7e }) {
		return failure()
	}
	address, addressErr := netip.ParseAddr(host)
	if addressErr == nil {
		canonicalAddress := address.String()
		if address.Is4In6() {
			bytes := address.As16()
			canonicalAddress = fmt.Sprintf("::ffff:%x:%x", uint16(bytes[12])<<8|uint16(bytes[13]), uint16(bytes[14])<<8|uint16(bytes[15]))
		}
		if address.Zone() != "" || canonicalAddress != host {
			return failure()
		}
	}
	if addressErr != nil {
		labels := strings.Split(strings.TrimSuffix(host, "."), ".")
		last := labels[len(labels)-1]
		_, decimalErr := strconv.ParseUint(last, 10, 64)
		_, prefixedErr := strconv.ParseUint(last, 0, 64)
		if decimalErr == nil || prefixedErr == nil {
			return failure()
		}
	}
	if origin.Scheme == "http" && host != "localhost" && (addressErr != nil || !address.Unmap().IsLoopback()) {
		return failure()
	}
	return nil
}
