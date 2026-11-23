// Package azureidentity constructs Azure managed identity credentials for service clients.
package azureidentity

import (
	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
)

// NewManagedIdentityCredential constructs a reusable SDK credential. An empty
// clientID selects the host's system-assigned identity; otherwise it selects
// the user-assigned identity with that client ID. The SDK obtains and refreshes
// tokens and returns its construction and authentication errors to the caller.
func NewManagedIdentityCredential(clientID string) (azcore.TokenCredential, error) {
	options := &azidentity.ManagedIdentityCredentialOptions{}
	if clientID != "" {
		options.ID = azidentity.ClientID(clientID)
	}
	credential, err := azidentity.NewManagedIdentityCredential(options)
	if err != nil {
		return nil, err
	}
	return credential, nil
}
