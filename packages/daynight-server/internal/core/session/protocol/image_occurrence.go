package sessionprotocol

type ImageOccurrenceStatus struct {
	ImageID    string      `json:"imageId"`
	Revision   string      `json:"revision"`
	State      string      `json:"state"`
	ResourceID *string     `json:"resourceId"`
	Action     string      `json:"action"`
	Error      *ImageError `json:"error"`
}
type ImageOccurrenceRetryReceipt struct {
	Capture ImageCaptureReceipt `json:"capture"`
}
