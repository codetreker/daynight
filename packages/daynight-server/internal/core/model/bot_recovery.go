package model

// BotRecovery preserves the independent recovery identity and current host.
// IdentityHash is never part of a public representation or recoverable secret.
type BotRecovery struct {
	WorkerID          string
	ServiceOrigin     string
	MachineID         string
	MachineName       string
	IdentityHash      []byte `json:"-"`
	HostingGeneration int64
}
