import pandas as pd
import numpy as np
import xgboost as xgb
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, classification_report
import joblib
import os

def load_data(filepath="data/training_data.csv"):
    """
    Loads historical feature vectors and targets.
    Expected columns: feat_0 to feat_N, and 'target' (1 for UP, 0 for DOWN/FLAT)
    """
    if not os.path.exists(filepath):
        print(f"No training data found at {filepath}")
        # Return mock data for demonstration
        np.random.seed(42)
        X = np.random.uniform(-1, 1, (1000, 12))
        y = np.random.randint(0, 2, 1000)
        return X, y
        
    df = pd.read_csv(filepath)
    feature_cols = [c for c in df.columns if c.startswith('feat_')]
    X = df[feature_cols].values
    y = df['target'].values
    return X, y

def train_model():
    print("Loading data...")
    X, y = load_data()
    
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    
    print(f"Training XGBoost model on {len(X_train)} samples...")
    
    # Initialize XGBoost classifier with parameters suited for noisy financial data
    model = xgb.XGBClassifier(
        n_estimators=100,
        max_depth=3,          # Keep shallow to prevent overfitting
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        objective='binary:logistic',
        eval_metric='logloss'
    )
    
    # Train
    model.fit(
        X_train, y_train,
        eval_set=[(X_test, y_test)],
        verbose=10
    )
    
    # Evaluate
    print("\nEvaluating model...")
    preds = model.predict(X_test)
    acc = accuracy_score(y_test, preds)
    print(f"Accuracy: {acc:.4f}")
    print("\nClassification Report:")
    print(classification_report(y_test, preds))
    
    # Save model
    os.makedirs("models", exist_ok=True)
    model_path = "models/xgboost_predictor.json"
    model.save_model(model_path)
    print(f"Model saved to {model_path}")

if __name__ == "__main__":
    train_model()
