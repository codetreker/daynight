package testauth

import (
	"net"
	"net/url"
	"strconv"
)

// PreviewOrigin gives numeric-loopback fixtures an explicit distinct same-site origin.
func PreviewOrigin(origin string) string {
	parsed, err := url.Parse(origin)
	if err != nil {
		panic(err)
	}
	host, value, err := net.SplitHostPort(parsed.Host)
	if err != nil {
		panic(err)
	}
	port, err := strconv.Atoi(value)
	if err != nil {
		panic(err)
	}
	if port == 65535 {
		port--
	} else {
		port++
	}
	return parsed.Scheme + "://" + net.JoinHostPort(host, strconv.Itoa(port))
}
