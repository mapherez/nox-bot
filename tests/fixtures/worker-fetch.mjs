// Network fixtures loaded only by the injected launcher in integration tests.
globalThis.fetch = async url => {
  const address = new URL(url);
  if (address.hostname === 'api.openweathermap.org') return new Response(JSON.stringify(address.pathname.includes('/geo/') ? [{ name: 'London', country: 'GB', lat: 51, lon: 0 }] : { name: 'London', sys: { country: 'GB' }, weather: [{ description: 'clear sky', icon: '01d' }], main: { temp: 18, feels_like: 17, humidity: 45, pressure: 1010 }, wind: { speed: 3 }, visibility: 10000 }));
  if (address.hostname === 'dicionario.priberam.org') return address.pathname.endsWith('.png') ? new Response(new Uint8Array([1, 2, 3])) : new Response('<img class="imagemdef" src="/definition.png"><div class="def">Portuguese definition fixture</div>');
  throw new Error('Unexpected test network request.');
};
