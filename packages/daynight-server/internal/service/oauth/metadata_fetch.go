package oauth

import (
	"container/list"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	metadataMaxBytes = 64 << 10
	metadataMaxCache = 1024
	metadataLifetime = time.Hour
	metadataTimeout  = 5 * time.Second
)

// ErrMetadataFetch intentionally excludes the client's URL and network diagnostics.
var ErrMetadataFetch = errors.New("unable to retrieve client metadata")

type metadataCacheEntry struct {
	id       string
	body     []byte
	deadline time.Time
}

// MetadataFetcher bounds and isolates remote client metadata retrieval. A fetcher
// is shared across requests so its concurrency and cache limits apply per instance.
type MetadataFetcher struct {
	mu        sync.Mutex
	entries   map[string]*list.Element
	lru       list.List
	slots     chan struct{}
	lookup    func(context.Context, string) ([]netip.Addr, error)
	dial      func(context.Context, string, string) (net.Conn, error)
	now       func() time.Time
	tlsConfig *tls.Config
}

func NewMetadataFetcher() *MetadataFetcher {
	return &MetadataFetcher{
		entries: make(map[string]*list.Element),
		slots:   make(chan struct{}, 4),
		lookup: func(ctx context.Context, host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		},
		dial: (&net.Dialer{}).DialContext,
		now:  time.Now,
	}
}

// Fetch returns a private copy and its expiration. validate must check the
// complete document against clientID; unsuccessful validation is never cached.
// Callers must acquire the persistent start budget before invoking Fetch.
func (f *MetadataFetcher) Fetch(ctx context.Context, clientID string, validate func([]byte) error) ([]byte, time.Time, error) {
	u, err := metadataURL(clientID)
	if err != nil || validate == nil {
		return nil, time.Time{}, ErrMetadataFetch
	}
	if body, deadline, ok := f.cached(clientID); ok {
		if err := validate(append([]byte(nil), body...)); err != nil {
			f.evict(clientID)
			return nil, time.Time{}, err
		}
		return body, deadline, nil
	}

	ctx, cancel := context.WithTimeout(ctx, metadataTimeout)
	defer cancel()
	select {
	case f.slots <- struct{}{}:
		defer func() { <-f.slots }()
	case <-ctx.Done():
		return nil, time.Time{}, ctx.Err()
	}

	body, err := f.retrieve(ctx, u)
	if err != nil {
		if ctx.Err() != nil {
			return nil, time.Time{}, ctx.Err()
		}
		return nil, time.Time{}, ErrMetadataFetch
	}
	if err := validate(append([]byte(nil), body...)); err != nil {
		return nil, time.Time{}, err
	}
	deadline := f.now().Add(metadataLifetime)
	f.remember(clientID, body, deadline)
	return append([]byte(nil), body...), deadline, nil
}

func metadataURL(id string) (*url.URL, error) {
	u, err := url.Parse(id)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.Hostname() == "" || u.User != nil || u.Opaque != "" || strings.Contains(id, "#") || strings.Contains(u.Hostname(), "%") {
		return nil, ErrMetadataFetch
	}
	return u, nil
}

func (f *MetadataFetcher) retrieve(ctx context.Context, u *url.URL) ([]byte, error) {
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		port = "443"
	}
	var addresses []netip.Addr
	if ip, err := netip.ParseAddr(host); err == nil {
		addresses = []netip.Addr{ip}
	} else {
		var err error
		addresses, err = f.lookup(ctx, host)
		if err != nil {
			return nil, ErrMetadataFetch
		}
	}
	if len(addresses) == 0 {
		return nil, ErrMetadataFetch
	}
	for _, ip := range addresses {
		if !publicMetadataIP(ip) {
			return nil, ErrMetadataFetch
		}
	}
	// Never let Transport resolve a hostname or reuse a connection validated for
	// another fetch. Every possible DNS answer must be safe, and the connection
	// is made to one of the checked literals while TLS verifies the URL hostname.
	transport := &http.Transport{
		Proxy:             nil,
		TLSClientConfig:   f.tlsConfig,
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			if addr != net.JoinHostPort(host, port) {
				return nil, ErrMetadataFetch
			}
			for _, ip := range addresses {
				if !publicMetadataIP(ip) {
					return nil, ErrMetadataFetch
				}
				conn, err := f.dial(ctx, "tcp", net.JoinHostPort(ip.Unmap().String(), port))
				if err == nil {
					return conn, nil
				}
			}
			return nil, ErrMetadataFetch
		},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, ErrMetadataFetch
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, metadataMaxBytes+1))
	if err != nil || len(body) > metadataMaxBytes {
		return nil, ErrMetadataFetch
	}
	return body, nil
}

var nonPublicMetadataNetworks = func() []netip.Prefix {
	// Special-use ranges, including shared address space, documentation,
	// benchmarking, translation and tunneling prefixes, are not destinations.
	ranges := []string{"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "64:ff9b:1::/48", "100::/64", "2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20", "fc00::/7", "fe80::/10", "ff00::/8"}
	result := make([]netip.Prefix, 0, len(ranges))
	for _, s := range ranges {
		result = append(result, netip.MustParsePrefix(s))
	}
	return result
}()

func publicMetadataIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || ip.Zone() != "" || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLinkLocalUnicast() {
		return false
	}
	if ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	for _, p := range nonPublicMetadataNetworks {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}

func (f *MetadataFetcher) cached(id string) ([]byte, time.Time, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	e := f.entries[id]
	if e == nil {
		return nil, time.Time{}, false
	}
	entry := e.Value.(metadataCacheEntry)
	if !f.now().Before(entry.deadline) {
		delete(f.entries, id)
		f.lru.Remove(e)
		return nil, time.Time{}, false
	}
	f.lru.MoveToFront(e)
	return append([]byte(nil), entry.body...), entry.deadline, true
}

func (f *MetadataFetcher) evict(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.entries[id]; e != nil {
		delete(f.entries, id)
		f.lru.Remove(e)
	}
}

func (f *MetadataFetcher) remember(id string, body []byte, deadline time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if e := f.entries[id]; e != nil {
		f.lru.Remove(e)
	}
	f.entries[id] = f.lru.PushFront(metadataCacheEntry{id: id, body: append([]byte(nil), body...), deadline: deadline})
	if f.lru.Len() > metadataMaxCache {
		e := f.lru.Back()
		delete(f.entries, e.Value.(metadataCacheEntry).id)
		f.lru.Remove(e)
	}
}
