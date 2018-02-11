let i = 0;
let foo;
do {
	console.log(`loop iteration ${i++}`);
	if (i === 0) {
		console.log('call continue')
		continue;
	}
	foo = 'test';
} while(console.log('will be cheched') && foo !== 'test');
