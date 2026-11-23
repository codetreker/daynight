package azureidentity

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
)

func clearIdentityEnvironment(t *testing.T) {
	t.Helper()
	for _, key := range []string{"IDENTITY_ENDPOINT", "IDENTITY_HEADER", "IDENTITY_SERVER_THUMBPRINT", "IMDS_ENDPOINT", "MSI_ENDPOINT", "MSI_SECRET", "DEFAULT_IDENTITY_CLIENT_ID"} {
		t.Setenv(key, "")
	}
}

func TestManagedIdentitySelection(t *testing.T) {
	for _, tc := range []struct {
		name, clientID string
	}{
		{name: "system"},
		{name: "user", clientID: "selected-client-id"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			clearIdentityEnvironment(t)
			requests := make(chan *http.Request, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				select {
				case requests <- r.Clone(r.Context()):
				default:
					t.Error("unexpected additional identity request")
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprintf(w, `{"access_token":"test-token-%s","expires_on":"%d","resource":"https://%s.example","token_type":"Bearer"}`, tc.name, time.Now().Add(time.Hour).Unix(), tc.name)
			}))
			defer server.Close()
			t.Setenv("IDENTITY_ENDPOINT", server.URL)
			t.Setenv("IDENTITY_HEADER", "test-header")

			credential, err := NewManagedIdentityCredential(tc.clientID)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			token, err := credential.GetToken(ctx, policy.TokenRequestOptions{Scopes: []string{"https://" + tc.name + ".example/.default"}})
			if err != nil {
				t.Fatal(err)
			}
			if token.Token != "test-token-"+tc.name || !token.ExpiresOn.After(time.Now()) {
				t.Fatalf("unexpected token: %#v", token)
			}
			select {
			case request := <-requests:
				if request.Method != http.MethodGet || request.Header.Get("X-IDENTITY-HEADER") != "test-header" {
					t.Errorf("unexpected identity request: %s, headers %v", request.Method, request.Header)
				}
				query := request.URL.Query()
				if query.Get("resource") != "https://"+tc.name+".example" || query.Get("client_id") != tc.clientID {
					t.Errorf("unexpected identity selection: %v", query)
				}
				if tc.clientID == "" && query.Has("client_id") {
					t.Errorf("system identity request included client_id: %v", query)
				}
			default:
				t.Fatal("identity endpoint was not called")
			}
		})
	}
}

func TestManagedIdentityErrors(t *testing.T) {
	t.Run("construction", func(t *testing.T) {
		clearIdentityEnvironment(t)
		t.Setenv("MSI_ENDPOINT", "http://127.0.0.1:1")
		_, upstream := azidentity.NewManagedIdentityCredential(&azidentity.ManagedIdentityCredentialOptions{ID: azidentity.ClientID("selected-client-id")})
		if upstream == nil {
			t.Fatal("SDK accepted a user-assigned identity on Cloud Shell")
		}
		credential, err := NewManagedIdentityCredential("selected-client-id")
		if credential != nil || err == nil || err.Error() != upstream.Error() {
			t.Fatalf("credential = %v, error = %v; want SDK error %v", credential, err, upstream)
		}
	})
	t.Run("token", func(t *testing.T) {
		clearIdentityEnvironment(t)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "identity denied", http.StatusUnauthorized)
		}))
		defer server.Close()
		t.Setenv("IDENTITY_ENDPOINT", server.URL)
		t.Setenv("IDENTITY_HEADER", "test-header")
		credential, err := NewManagedIdentityCredential("")
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, err = credential.GetToken(ctx, policy.TokenRequestOptions{Scopes: []string{"https://failure.example/.default"}})
		var authError *azidentity.AuthenticationFailedError
		if !errors.As(err, &authError) || !strings.Contains(err.Error(), "identity denied") {
			t.Fatalf("expected SDK authentication error containing endpoint failure, got %v", err)
		}
	})
}
