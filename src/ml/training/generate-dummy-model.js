const tf = require('@tensorflow/tfjs-node');

async function createDummyModel() {
    const model = tf.sequential();
    
    // The expected input shape in ml-predictor.ts is [1, 50, 7]
    model.add(tf.layers.flatten({ inputShape: [50, 7] }));
    model.add(tf.layers.dense({ units: 16, activation: 'relu' }));
    
    // Softmax output for 2 classes (Up, Down)
    model.add(tf.layers.dense({ units: 2, activation: 'softmax' }));
    
    model.compile({
        optimizer: 'adam',
        loss: 'categoricalCrossentropy',
        metrics: ['accuracy']
    });

    const modelPath = 'file://./src/ml/model';
    console.log(`Saving dummy model to ${modelPath}...`);
    await model.save(modelPath);
    console.log('Model saved successfully!');
}

createDummyModel().catch(console.error);
