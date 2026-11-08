package httpoutbound

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"
)

func TestProductionTransportRejectsPrivateMappedAndTransitionAddresses(t *testing.T) {
	for _, address := range []string{"10.0.0.1", "127.0.0.1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "64:ff9b:1::1", "2001::1234", "2002:7f00:1::"} {
		t.Run(address, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			c := New()
			// An exact policy error from dial proves no network dial was attempted.
			if conn, err := c.dial(ctx, "tcp", net.JoinHostPort(address, "443")); err != ErrTransport {
				if conn != nil {
					conn.Close()
				}
				t.Fatalf("address was not denied by policy: %v", err)
			}
			if _, err := c.Do(ctx, "https://"+net.JoinHostPort(address, "443")+"/", nil, nil); !errors.Is(err, ErrTransport) {
				t.Fatalf("request was not denied: %v", err)
			}
		})
	}
}
