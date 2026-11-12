/** A different process birth proves the PID no longer identifies the bootstrap. */
export class ControllerBootstrapReplacedError extends Error {
  constructor(message = "Controller bootstrap process identity was replaced.", options?: ErrorOptions) {
    super(message, options);
    this.name = "ControllerBootstrapReplacedError";
  }
}
