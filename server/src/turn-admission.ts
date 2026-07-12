export class TurnAdmission {
  #inFlight = 0;

  get inFlight() { return this.#inFlight; }

  tryBegin(accepting:boolean) {
    if (!accepting) return false;
    this.#inFlight++;
    return true;
  }

  end() {
    if (this.#inFlight <= 0) throw new Error('turn admission released without a matching admission');
    this.#inFlight--;
  }
}
