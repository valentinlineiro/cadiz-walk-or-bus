/** Normalises any port to an ArrivalsResult: a thrown error is `unavailable`, never `[]`. */
export async function arrivalsResultOf(port, stopId) {
    try {
        if (typeof port.getArrivalsResult === 'function')
            return await port.getArrivalsResult(stopId);
        return { status: 'live', arrivals: await port.getArrivals(stopId) };
    }
    catch {
        return { status: 'unavailable', cause: 'source_error' };
    }
}
