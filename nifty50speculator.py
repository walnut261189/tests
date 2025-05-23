import yfinance as yf
import pandas as pd
import numpy as np
from sklearn.linear_model import LinearRegression
from datetime import datetime, timedelta
import matplotlib.pyplot as plt

# 1. Fetch historical data for Nifty 50 (^NSEI)
def get_nifty_data(period='1y'):
    nifty = yf.Ticker("^NSEI")
    df = nifty.history(period=period)
    return df

# 2. Prepare data for regression
def prepare_data(df):
    df['Open_next'] = df['Open'].shift(-1)  # Predict next day opening
    df = df.dropna()
    df['DayIndex'] = np.arange(len(df))
    X = df[['DayIndex']]
    y = df['Open_next']
    return X, y, df

# 3. Train model and predict
def predict_next_open(X, y):
    model = LinearRegression()
    model.fit(X, y)
    next_day_index = [[X.iloc[-1]['DayIndex'] + 1]]
    predicted_open = model.predict(next_day_index)[0]
    return predicted_open

# 4. Main function
def main():
    print("Fetching Nifty 50 data...")
    df = get_nifty_data()
    X, y, full_df = prepare_data(df)
    prediction = predict_next_open(X, y)
    print(f"Predicted Nifty 50 Opening for Next Trading Day: {prediction:.2f}")

    # Optional: Plot
    plt.plot(full_df['Open'], label='Actual Open')
    plt.plot(full_df['Open_next'], label='Next Day Open')
    plt.legend()
    plt.title('Nifty 50 Opening Prices')
    plt.show()

if __name__ == "__main__":
    main()
