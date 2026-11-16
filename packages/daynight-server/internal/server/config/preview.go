package config

import (
	"errors"
	"net"
	"strings"

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
	"golang.org/x/net/publicsuffix"
)

func (c Config) ValidatePreviewOrigin() error {
	main, err := authconfig.ValidatePublicOrigin(authconfig.AuthSettings{PublicOrigin: c.PublicOrigin, AllowHTTPTestOrigin: c.AllowHTTPTestOrigin})
	if err != nil {
		return err
	}
	preview, err := authconfig.ValidatePublicOrigin(authconfig.AuthSettings{PublicOrigin: c.PreviewOrigin, AllowHTTPTestOrigin: c.AllowHTTPTestOrigin})
	if err != nil {
		var failure *configvalue.ConfigurationError
		if errors.As(err, &failure) {
			copy := *failure
			copy.Field = "preview_origin"
			return &copy
		}
		return err
	}
	reject := func(rule string) error {
		return &configvalue.ConfigurationError{Field: "preview_origin", Rule: rule}
	}
	mainHost, previewHost := main.Hostname(), preview.Hostname()
	if address := net.ParseIP(mainHost); c.AllowHTTPTestOrigin && main.Scheme == "http" && preview.Scheme == "http" && address != nil && address.IsLoopback() && previewHost == mainHost && main.Host != preview.Host {
		return nil
	}
	if !canonicalDNSHost(mainHost) || !canonicalDNSHost(previewHost) {
		return reject("requires canonical DNS hostnames for the main and preview origins")
	}
	if preview.Scheme != main.Scheme || mainHost == previewHost || strings.HasSuffix(mainHost, "."+previewHost) {
		return reject("must use the main-site scheme and a preview cookie domain that excludes the main host")
	}
	mainSite, mainErr := publicsuffix.EffectiveTLDPlusOne(mainHost)
	previewSite, previewErr := publicsuffix.EffectiveTLDPlusOne(previewHost)
	if mainErr != nil || previewErr != nil || mainSite != previewSite {
		return reject("must share the main site's registrable domain")
	}
	if main.Scheme == "http" && (!localTestHost(mainHost) || !localTestHost(previewHost)) {
		return reject("HTTP test origins require local .test or .localhost hostnames")
	}
	return nil
}

func canonicalDNSHost(value string) bool {
	if len(value) > 253 || net.ParseIP(value) != nil || !strings.Contains(value, ".") {
		return false
	}
	for _, label := range strings.Split(value, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, char := range label {
			if char != '-' && (char < 'a' || char > 'z') && (char < '0' || char > '9') {
				return false
			}
		}
	}
	return true
}

func localTestHost(value string) bool {
	return strings.HasSuffix(value, ".test") || strings.HasSuffix(value, ".localhost")
}
