import streamlit as st

st.set_page_config(page_title="Simple App")

st.title("Hello from Streamlit!")
st.write("This app was deployed via GitHub.")

name = st.text_input("What is your name?")
if name:
    st.success(f"Hello, {name}!")

if st.button("Click me"):
    st.balloons()
