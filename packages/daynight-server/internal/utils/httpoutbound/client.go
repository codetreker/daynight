package httpoutbound

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	MaxURLBytes            = 4096
	MaxBodyBytes           = 65536
	MaxResponseBytes       = 2048
	MaxResponseHeaderBytes = 16384
)

// Resolver is deliberately separate from dialing: only checked numeric addresses are dialed.
type Resolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}

type Client struct {
	resolver Resolver
	allow    func(netip.Addr) bool
	roots    *x509.CertPool
}

// New creates the production client. The destination owner cannot alter its policy or trust roots.
func New() *Client { return &Client{resolver: net.DefaultResolver, allow: PublicAddress} }

// NewForTesting supplies controlled resolver, address policy, and trusted test CA.
// TLS hostname and certificate verification remain enabled.
func NewForTesting(resolver Resolver, allow func(netip.Addr) bool, roots *x509.CertPool) *Client {
	if resolver == nil || allow == nil || roots == nil {
		panic("test transport requires explicit dependencies")
	}
	return &Client{resolver: resolver, allow: allow, roots: roots}
}

// Response contains only bounded data intended for adapter classification. Callers must
// not persist Body, ReadError details, or raw authentication and response headers.
type Response struct {
	Status     int
	RetryAfter string
	Body       []byte
	Truncated  bool
	ReadError  bool
}

var ErrInvalidRequest = errors.New("invalid outbound request")
var ErrTransport = errors.New("outbound request failed")

// Failure preserves a cause for inspection while keeping destination details out
// of routine error formatting. Callers must not log the unwrapped cause verbatim.
type Failure struct{ Cause error }

func (e *Failure) Error() string        { return ErrTransport.Error() }
func (e *Failure) Unwrap() error        { return e.Cause }
func (e *Failure) Is(target error) bool { return target == ErrTransport }

// Do sends one HTTPS POST without proxies, redirects, connection reuse or unchecked DNS.
// Returned errors are intentionally sanitized and never contain the destination URL.
func (c *Client) Do(ctx context.Context, target string, body []byte, headers http.Header) (Response, error) {
	var out Response
	if len(body) > MaxBodyBytes || !validTarget(target) {
		return out, ErrInvalidRequest
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	transport := &http.Transport{
		Proxy: nil, DisableKeepAlives: true, DisableCompression: true,
		TLSClientConfig:     &tls.Config{RootCAs: c.roots, MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 10 * time.Second,
		MaxResponseHeaderBytes: MaxResponseHeaderBytes,
		DialContext:            c.dial,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return out, ErrInvalidRequest
	}
	req.Header = headers.Clone()
	resp, err := client.Do(req)
	if err != nil {
		return out, &Failure{Cause: err}
	}
	defer resp.Body.Close()
	out.Status = resp.StatusCode
	// A 101 body is an upgraded bidirectional stream, not an HTTP response
	// body. It may ignore request cancellation, so close it without reading.
	if resp.StatusCode == http.StatusSwitchingProtocols {
		return out, nil
	}
	// Retry-After is needed only for these statuses and is bounded by the header cap.
	if resp.StatusCode == 429 || resp.StatusCode == 503 {
		out.RetryAfter = strings.Join(resp.Header.Values("Retry-After"), ", ")
	}
	b, readErr := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBytes+1))
	if len(b) > MaxResponseBytes {
		out.Truncated = true
		b = b[:MaxResponseBytes]
	}
	out.Body, out.ReadError = b, readErr != nil
	return out, nil
}

func validTarget(target string) bool {
	if !utf8.ValidString(target) || len(target) > MaxURLBytes || strings.Contains(target, "#") {
		return false
	}
	u, err := url.Parse(target)
	if err != nil || u.Scheme != "https" || u.Opaque != "" || u.Host == "" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || strings.ContainsFunc(u.Hostname(), func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) {
		return false
	}
	if _, err := url.QueryUnescape(u.RawQuery); err != nil {
		return false
	}
	size := 0
	for _, b := range []byte(u.String()) {
		if b >= 0x80 {
			size += 3
		} else {
			size++
		}
	}
	return size <= MaxURLBytes
}

func (c *Client) dial(ctx context.Context, network, address string) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, ErrTransport
	}
	var ips []netip.Addr
	if ip, err := netip.ParseAddr(host); err == nil {
		ips = []netip.Addr{ip}
	} else {
		ips, err = c.resolver.LookupNetIP(ctx, "ip", host)
		if err != nil {
			return nil, &Failure{Cause: err}
		}
	}
	var dialer net.Dialer
	var lastErr error
	for _, ip := range ips {
		ip = ip.Unmap()
		if !c.allow(ip) {
			continue
		}
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	if lastErr != nil {
		return nil, &Failure{Cause: lastErr}
	}
	return nil, ErrTransport
}
