package model

func Unauthenticated(cause error) error {
	return &Fault{Code: "unauthenticated", Message: "Authentication is required. Please log in again.", Cause: cause}
}
